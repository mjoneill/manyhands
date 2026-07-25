/**
 * #249 — stored XSS in the board's renderCard. Four identifier/enum fields
 * (id, type, assignee, priority) were interpolated raw into HTML attributes and
 * then assigned via el.innerHTML, so a card carrying a `">…<img onerror>` payload
 * in any of them executed script in every viewer's board. The server now
 * validates those fields (api-security.test.mjs), but the RENDER must also be
 * safe on its own — a bad value reaching the DOM from any source (pre-validation
 * data, a direct file edit) must render inert. This loads a fixture with all
 * four fields poisoned (bypassing API validation) and asserts nothing breaks out.
 *
 * Puppeteer against an isolated server (own port + temp board) — never live :3141.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startRestServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
// Each payload tries to break out of a "…"-quoted attribute and inject an <img>
// whose onerror would run script. data-pwn tags which field broke out.
const PWN = (field) => `x"><img data-pwn="${field}" src=q onerror="window.__pwned=(window.__pwned||0)+1">`;

const board = {
  cards: [{
    id: PWN('id'),
    shortId: 1,
    title: 'Safe Title',
    description: '',
    type: PWN('type'),
    assignees: [PWN('assignee')],
    labels: ['a-label'], // present so data-card-type actually renders
    for: '',
    priority: PWN('priority'),
    column: 'backlog',
    order: 0,
    createdAt: ts,
    updatedAt: ts,
    relationships: { relatedTo: [], blockedBy: [] },
  }],
  columns: [
    { id: 'backlog', name: 'Backlog', order: 0 },
    { id: 'done', name: 'Done', order: 1 },
  ],
  conversations: [],
  nextShortId: 2,
};

test('#249 renderCard neutralizes XSS in id/type/assignee/priority — no attribute breakout, no script exec', async () => {
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });
    // Give any injected onerror a tick to fire before we assert.
    await new Promise((r) => setTimeout(r, 250));

    const injected = await page.$$eval('img[data-pwn]', (els) => els.map((e) => e.getAttribute('data-pwn')));
    assert.deepEqual(injected, [], `no payload broke out of its attribute (broke out: ${injected.join(', ')})`);

    const pwned = await page.evaluate(() => window.__pwned || 0);
    assert.equal(pwned, 0, 'no injected onerror handler executed');

    // The card itself still renders (escaped, not destroyed).
    const title = await page.$eval('.card .card-title', (el) => el.textContent);
    assert.equal(title, 'Safe Title', 'the legitimate card still renders');
  } finally {
    await browser.close();
    await server.stop();
  }
});

// #299 — the column RENAME input interpolates the name into value="…" via an
// attribute-encoder. escapeHTML (used pre-#299) does NOT encode quotes, so a
// column name carrying `"><img onerror> autofocus` breaks out when rename opens.
// Column names are writable by any local agent (unvalidated PATCH pre-#299), so
// this is the same inter-agent trust boundary as the card fields above.
const COL_PWN = 'x"><img data-pwn="colname" src=q onerror="window.__pwned=(window.__pwned||0)+1"> autofocus="';

test('#299 column rename neutralizes XSS in the column name — no attribute breakout', async () => {
  // A CUSTOM column id (not a built-in) so its display name comes straight from
  // board data, not a hardcoded default — the poisoned name is what renders.
  // A card must exist for the board to hydrate columns from server data
  // (initBoard only restores server columns when cards.length > 0); otherwise it
  // falls back to the hardcoded default columns and the poisoned one never mounts.
  const board = {
    cards: [{
      id: 'c1', shortId: 1, title: 'Anchor', description: '', type: 'task',
      assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    columns: [
      { id: 'backlog', name: 'Backlog', order: 0 },
      { id: 'triage', name: COL_PWN, order: 1 },
    ],
    conversations: [],
    nextShortId: 2,
  };
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.column-header', { timeout: 5000 });

    // Enter rename mode on the poisoned column (double-click its header).
    await page.$eval('.column-header[data-column-id="triage"]', (h) => {
      h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 250)); // let any injected onerror fire

    const injected = await page.$$eval('img[data-pwn]', (els) => els.map((e) => e.getAttribute('data-pwn')));
    assert.deepEqual(injected, [], `rename name broke out of value="" (broke out: ${injected.join(', ')})`);
    const pwned = await page.evaluate(() => window.__pwned || 0);
    assert.equal(pwned, 0, 'no injected onerror executed from the column name');

    // The rename input exists and carries the full name as its literal value.
    const val = await page.$eval('.column-rename-input', (el) => el.value);
    assert.equal(val, COL_PWN, 'the input holds the raw name as a value, not as parsed markup');
  } finally {
    await browser.close();
    await server.stop();
  }
});
