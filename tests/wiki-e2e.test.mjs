/**
 * End-to-end smoke for the wiki UI (wiki.html). Loads the real page against an
 * isolated server, proving the whole stack: ES-module load (.mjs MIME) →
 * /api/nodes → tree render → /api/nodes/:id → page render (markdown + backlinks).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['sage'],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});

const board = {
  cards: [
    card('p', 1, 'Parent', { description: '# Welcome\n\nThis is the **parent** page.' }),
    card('c', 2, 'Child', { parent: 'p' }),
    card('l', 3, 'Linker', { description: 'see [[Parent]] for details' }),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 4,
};

test('wiki.html renders the tree and opens a page end-to-end', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });

    // Tree built from /api/nodes (proves module load + fetch + hierarchy render).
    await page.waitForSelector('#tree a', { timeout: 5000 });
    const labels = await page.$$eval('#tree a', (els) => els.map((e) => e.textContent));
    assert.ok(
      labels.includes('Parent') && labels.includes('Child') && labels.includes('Linker'),
      'tree renders all pages: ' + labels.join(', '),
    );

    // Open Parent → page view (markdown rendered + Linker backlink).
    await page.evaluate(() => {
      [...document.querySelectorAll('#tree a')].find((a) => a.textContent === 'Parent').click();
    });
    await page.waitForSelector('h1.page-title', { timeout: 5000 });
    const title = await page.$eval('h1.page-title', (e) => e.textContent);
    assert.equal(title, 'Parent');
    const bodyHtml = await page.$eval('article', (e) => e.innerHTML);
    assert.ok(bodyHtml.includes('<strong>parent</strong>'), 'markdown rendered');
    const backlinks = await page.$$eval('.section a', (els) => els.map((e) => e.textContent));
    assert.ok(backlinks.includes('Linker'), 'Linker shows as a backlink: ' + backlinks.join(', '));
  }, { server: { board }, launch: { headless: 'new' } });
});

test('wiki.html edits a page through the UI (Edit → change → Save)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree a', { timeout: 5000 });
    await page.evaluate(() => [...document.querySelectorAll('#tree a')].find((a) => a.textContent === 'Parent').click());
    await page.waitForSelector('.toolbar .btn', { timeout: 5000 });
    await page.evaluate(() => [...document.querySelectorAll('.toolbar .btn')].find((b) => b.textContent.includes('Edit')).click());
    await page.waitForSelector('.edit-body', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('.edit-body').value = 'edited via the **UI**'; });
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent === 'Save').click());
    await page.waitForFunction(() => document.querySelector('article')?.innerHTML.includes('edited via the'), { timeout: 5000 });
    const html = await page.$eval('article', (e) => e.innerHTML);
    assert.ok(html.includes('<strong>UI</strong>'), 'edited markdown re-rendered after save');
  }, { server: { board }, launch: { headless: 'new' } });
});

test('wiki.html deep-links via ?node= and shows the Board/Wiki nav (card→page jump)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html?node=c`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('h1.page-title', { timeout: 5000 });
    assert.equal(await page.$eval('h1.page-title', (e) => e.textContent), 'Child', 'deep-linked page opened on load');
    const nav = await page.$$eval('.navlink', (els) => els.map((e) => e.textContent));
    assert.ok(nav.some((t) => t.includes('Board')) && nav.some((t) => t.includes('Wiki')), 'nav bar present: ' + nav.join(','));
    const asCard = await page.$eval('.toolbar a.btn', (e) => e.getAttribute('href'));
    assert.ok(asCard.startsWith('/?focus='), 'page has an "open as card" link: ' + asCard);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('conversation-homing: post a comment on a page and it renders inline', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html?node=p`, { waitUntil: 'networkidle0' });
    // #226 — the homed thread now renders via the shared conversation-view component (.cv-*).
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('.cv-input').value = 'homed comment'; });
    // requestSubmit (not a click): the fixed commons toggle can overlap the Post
    // button at the page bottom — a geometry artifact, not a behavior bug.
    await page.evaluate(() => document.querySelector('.cv-form').requestSubmit());
    await page.waitForFunction(
      () => [...document.querySelectorAll('.cv-msg-body')].some((e) => e.textContent.includes('homed comment')),
      { timeout: 5000 },
    );
    const bodies = await page.$$eval('.cv-msg-body', (els) => els.map((e) => e.textContent));
    assert.ok(bodies.some((b) => b.includes('homed comment')), 'comment homed on the page: ' + bodies.join(' | '));
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#226 wiki commons panel: nav peer + slide-in panel posts to the floating commons', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });

    // The Commons nav peer is present (a co-equal full-page view).
    const nav = await page.$$eval('.navlink', (els) => els.map((e) => ({ t: e.textContent, href: e.getAttribute('href') })));
    assert.ok(nav.some((n) => n.t.includes('Commons') && n.href === '/commons.html'), 'Commons nav peer: ' + JSON.stringify(nav));

    // Open the slide-in panel and post — scoped to it via #commons-panel.
    await page.click('[data-commons-toggle]');
    await page.waitForSelector('#commons-panel.visible .cv-input', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('#commons-panel .cv-input').value = 'hello from the wiki panel'; });
    await page.evaluate(() => document.querySelector('#commons-panel .cv-form').requestSubmit());
    await page.waitForFunction(
      () => [...document.querySelectorAll('#commons-panel .cv-msg-body')].some((e) => e.textContent.includes('hello from the wiki panel')),
      { timeout: 5000 },
    );

    // It floated to the commons (attachedTo null) — a panel post is not homed to a node.
    const stored = await (await fetch(`${server.baseUrl}/api/conversations`)).json();
    const m = stored.find((c) => c.body === 'hello from the wiki panel');
    assert.ok(m && m.attachedTo === null, 'wiki panel post floats to the commons: ' + JSON.stringify(m));
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#229 wiki nav: filter narrows + keeps ancestors, field:value works, collapse toggles', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree .tree-row a', { timeout: 5000 });
    const names = () => page.$$eval('#tree .tree-row a', (els) => els.map((e) => e.textContent));

    const all = await names();
    assert.ok(all.includes('Parent') && all.includes('Child') && all.includes('Linker'), 'all shown: ' + all);

    // free-text filter → match + its ancestor; non-match pruned
    await page.type('#nav-filter', 'child');
    await page.waitForFunction(() => {
      const ns = [...document.querySelectorAll('#tree .tree-row a')].map((e) => e.textContent);
      return ns.includes('Child') && !ns.includes('Linker');
    }, { timeout: 5000 });
    const filtered = await names();
    assert.ok(filtered.includes('Child') && filtered.includes('Parent'), 'match + ancestor kept: ' + filtered);
    assert.ok(!filtered.includes('Linker'), 'non-match pruned');

    // field:value filter (id:3 → Linker only)
    await page.click('#nav-filter', { clickCount: 3 });
    await page.type('#nav-filter', 'id:3');
    await page.waitForFunction(() => {
      const ns = [...document.querySelectorAll('#tree .tree-row a')].map((e) => e.textContent);
      return ns.length === 1 && ns[0] === 'Linker';
    }, { timeout: 5000 });

    // clear filter, then collapse Parent → Child disappears
    await page.click('#nav-filter', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => [...document.querySelectorAll('#tree .tree-row a')].some((e) => e.textContent === 'Linker'), { timeout: 5000 });
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree .tree-row')];
      rows.find((r) => r.querySelector('a')?.textContent === 'Parent').querySelector('.tree-toggle').click();
    });
    await page.waitForFunction(() => ![...document.querySelectorAll('#tree .tree-row a')].some((e) => e.textContent === 'Child'), { timeout: 5000 });
    const collapsed = await names();
    assert.ok(!collapsed.includes('Child') && collapsed.includes('Parent'), 'Child hidden under collapsed Parent: ' + collapsed);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#229 wiki nav: sort toggle reorders (alpha / recent / newest)', async () => {
  const sortBoard = {
    cards: [
      card('x', 10, 'Banana', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }),
      card('y', 11, 'apple', { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
      card('z', 12, 'Cherry', { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [],
    nextShortId: 13,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree .tree-row a', { timeout: 5000 });
    const order = () => page.$$eval('#tree > ul > li > .tree-row a', (els) => els.map((e) => e.textContent));

    assert.deepEqual(await order(), ['apple', 'Banana', 'Cherry'], 'alpha default (case-insensitive)');

    await page.select('#nav-sort', 'edited');
    await page.waitForFunction(() => document.querySelector('#tree > ul > li > .tree-row a')?.textContent === 'Banana', { timeout: 5000 });
    assert.deepEqual(await order(), ['Banana', 'Cherry', 'apple'], 'recently-edited first');

    await page.select('#nav-sort', 'created');
    await page.waitForFunction(() => document.querySelector('#tree > ul > li > .tree-row a')?.textContent === 'apple', { timeout: 5000 });
    assert.deepEqual(await order(), ['apple', 'Cherry', 'Banana'], 'newest-created first');
  }, { server: { board: sortBoard }, launch: { headless: 'new' } });
});

test('#231 wiki nav: Done hidden by default; revealed by checkbox or column:done', async () => {
  const doneBoard = {
    cards: [
      card('a', 20, 'Active Page', { column: 'backlog' }),
      card('d', 21, 'Done Page', { column: 'done' }),
    ],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }, { id: 'done', name: 'Done', order: 1 }],
    conversations: [],
    nextShortId: 22,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree .tree-row a', { timeout: 5000 });
    const names = () => page.$$eval('#tree .tree-row a', (els) => els.map((e) => e.textContent));

    // default: Done hidden
    let shown = await names();
    assert.ok(shown.includes('Active Page') && !shown.includes('Done Page'), 'Done hidden by default: ' + shown);

    // checkbox reveals Done
    await page.click('#nav-showdone');
    await page.waitForFunction(() => [...document.querySelectorAll('#tree .tree-row a')].some((e) => e.textContent === 'Done Page'), { timeout: 5000 });
    assert.ok((await names()).includes('Done Page'), 'checkbox reveals Done');

    // uncheck; a generic filter stays Done-free
    await page.click('#nav-showdone');
    await page.type('#nav-filter', 'page'); // matches both names
    await page.waitForFunction(() => [...document.querySelectorAll('#tree .tree-row a')].some((e) => e.textContent === 'Active Page'), { timeout: 5000 });
    shown = await names();
    assert.ok(shown.includes('Active Page') && !shown.includes('Done Page'), 'generic filter stays Done-free: ' + shown);

    // column:done explicitly reveals Done (and only Done)
    await page.click('#nav-filter', { clickCount: 3 });
    await page.type('#nav-filter', 'column:done');
    await page.waitForFunction(() => {
      const ns = [...document.querySelectorAll('#tree .tree-row a')].map((e) => e.textContent);
      return ns.length === 1 && ns[0] === 'Done Page';
    }, { timeout: 5000 });
  }, { server: { board: doneBoard }, launch: { headless: 'new' } });
});

test('#240 wiki: opening a page sets a per-page URL, marks it active, and back navigates', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree .tree-row a', { timeout: 5000 });

    // open Parent via the tree → URL gains ?node=p and the nav marks it active
    await page.evaluate(() => [...document.querySelectorAll('#tree .tree-row a')].find((a) => a.textContent === 'Parent').click());
    await page.waitForFunction(() => new URL(location.href).searchParams.get('node') === 'p', { timeout: 5000 });
    assert.equal(await page.$eval('h1.page-title', (e) => e.textContent), 'Parent');
    assert.ok(await page.$('#tree a.active'), 'opened page is active in the nav');

    // open Linker → URL updates
    await page.evaluate(() => [...document.querySelectorAll('#tree .tree-row a')].find((a) => a.textContent === 'Linker').click());
    await page.waitForFunction(() => new URL(location.href).searchParams.get('node') === 'l', { timeout: 5000 });

    // back button returns to Parent (popstate routing)
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('node') === 'p', { timeout: 5000 });
    assert.equal(await page.$eval('h1.page-title', (e) => e.textContent), 'Parent', 'back button routed to Parent');
  }, { server: { board }, launch: { headless: 'new' } });
});

// #220 — drag-drop reparent. Synthetic HTML5 drag events (a shared DataTransfer)
// exercise the same handlers a real drag fires.
function dragDrop(page, srcText, tgtSelector) {
  return page.evaluate((srcText, tgtSelector) => {
    const dt = new DataTransfer();
    const src = [...document.querySelectorAll('#tree a')].find((a) => a.textContent.includes(srcText));
    const tgt = document.querySelector(tgtSelector);
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    tgt.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  }, srcText, tgtSelector);
}

test('#220 drag a page onto another reparents it (Child → under Linker)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree a', { timeout: 5000 });

    // Drag "Child" (under Parent) onto "Linker".
    const linkerSel = await page.evaluate(() => {
      const l = [...document.querySelectorAll('#tree a')].find((a) => a.textContent.includes('Linker'));
      l.id = 'tgt-linker'; return '#tgt-linker';
    });
    await dragDrop(page, 'Child', linkerSel);

    // Server reflects the move: c is now Linker's child.
    await page.waitForFunction(async () => {
      const { tree } = await (await fetch('/api/nodes')).json();
      const linker = tree.find((t) => t.id === 'l');
      return linker && linker.children.some((k) => k.id === 'c');
    }, { timeout: 5000 });
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#220 dropping a page onto its own descendant is refused (no cycle)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree a', { timeout: 5000 });

    // Drag "Parent" onto its child "Child" — invalid; client offers no drop.
    const childSel = await page.evaluate(() => {
      const c = [...document.querySelectorAll('#tree a')].find((a) => a.textContent.includes('Child'));
      c.id = 'tgt-child'; return '#tgt-child';
    });
    await dragDrop(page, 'Parent', childSel);
    await new Promise((r) => setTimeout(r, 400));

    // p stays a root with c under it — nothing moved.
    const intact = await page.evaluate(async () => {
      const { tree } = await (await fetch('/api/nodes')).json();
      const p = tree.find((t) => t.id === 'p');
      return !!(p && p.children.some((k) => k.id === 'c'));
    });
    assert.ok(intact, 'cycle drop refused — p→c hierarchy intact');
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#220 dropping a page on the "PAGES" heading makes it top-level', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#tree a', { timeout: 5000 });

    // Drag "Child" (under Parent) onto the PAGES heading → becomes a root.
    await dragDrop(page, 'Child', '#pages-heading');
    await page.waitForFunction(async () => {
      const { tree } = await (await fetch('/api/nodes')).json();
      return tree.some((t) => t.id === 'c'); // c is now a top-level root
    }, { timeout: 5000 });
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#222 a page with an image attachment renders it inline; edit mode shows the uploader', async () => {
  const attBoard = {
    cards: [{
      id: 'm', shortId: 1, title: 'Media Page', description: 'has a picture',
      type: 'reference', assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
      attachments: [{ id: 'demo.png', name: 'demo.png', mime: 'image/png', size: 100 }],
    }],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [], nextShortId: 2,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/wiki.html?node=m`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.page-title', { timeout: 5000 });

    // The image attachment renders inline in the Attachments section.
    const imgSrc = await page.$eval('.attach-img', (e) => e.getAttribute('src')).catch(() => null);
    assert.ok(imgSrc && imgSrc.includes('/api/attachments/demo.png'), 'image attachment rendered: ' + imgSrc);

    // Edit mode exposes the file uploader.
    await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('Edit')).click());
    await page.waitForSelector('.edit-body', { timeout: 3000 });
    const hasUploader = await page.$('input[type=file]');
    assert.ok(hasUploader, 'edit mode has a file uploader');
    // The existing attachment shows in the edit list with a remove control.
    const editItem = await page.$eval('.attach-edit-item', (e) => e.textContent).catch(() => '');
    assert.ok(editItem.includes('demo.png'), 'existing attachment listed in edit mode: ' + editItem);
  }, { server: { board: attBoard }, launch: { headless: 'new' } });
});
