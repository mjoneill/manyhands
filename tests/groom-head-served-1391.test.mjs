/**
 * #1391 — the grooming view shows the CARD, not only its thread. Found live
 * by the owner in the first thirty seconds of using #1368: "no way to see
 * what's on the card right now … not sure what happens when I post."
 *
 *   · the card's head (title · meta · description with refs live · doors)
 *     sits above the thread on commons.html?node=<card>;
 *   · one line above the composer says what posting does and names the PO
 *     from the board (roster / declaration), or says nobody holds it;
 *   · a non-card node's thread is unchanged (no head, no line).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title, description = '') => ({
  id: `c${shortId}`, shortId, title, description, type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: ['ux'], priority: 'p1', createdAt: ts, updatedAt: ts, version: 1,
});
const SEATS = { ada: { name: 'Ada', color: '#7cc4a0' }, pip: { name: 'Pip', color: '#c47c7c' } };

test('#1391 served: Groom-this shows the card above the thread, refs live, doors present, and the line names the PO', async () => {
  const rosterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'groom-head-')), 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS, roles: { po: 'pip' } }));
  const board = makeBoardFixture({ cards: [card(1, 'the card being groomed', 'what exists today, see #2'), card(2, 'a neighbour')], nextShortId: 3 });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.accept(); });
    await page.goto(`${server.baseUrl}/commons.html?node=c1&groom=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form[data-groom="1"] .cv-input', { timeout: 5000 });
    // the card is visible, above the composer
    const head = await page.$('#thread-head.card-head');
    assert.ok(head, 'the card head renders on the grooming page');
    assert.equal(await page.$eval('#thread-head .card-head-title', (e) => e.textContent), 'the card being groomed');
    // a 600px-tall window: the description folds behind one toggle so the feed keeps its height; open it
    if (await page.$eval('#thread-head .card-head-body', (e) => e.hidden)) await page.click('#thread-head .card-head-toggle');
    await page.waitForFunction(() => !document.querySelector('#thread-head .card-head-body').hidden, { timeout: 3000 });
    assert.match(await page.$eval('#thread-head .card-head-body', (e) => e.textContent), /what exists today/);
    assert.ok(await page.evaluate(() => document.querySelector('.cv-feed').getBoundingClientRect().height > 40), 'the feed keeps a usable height with the head open');
    const placed = await page.evaluate(() => {
      const head = document.querySelector('#thread-head');
      const feed = document.querySelector('.cv-feed');
      return { inFeed: feed.contains(head), first: feed.firstElementChild === head, aboveForm: head.getBoundingClientRect().top < document.querySelector('.cv-form').getBoundingClientRect().top };
    });
    assert.deepEqual(placed, { inFeed: true, first: true, aboveForm: true }, 'the head is the first thing in the feed, scrolling with it, above the composer');
    assert.match(await page.$eval('#thread-head .card-head-eyebrow', (e) => e.textContent), /#1/);
    assert.equal(await page.$eval('#thread-head .card-head-link.edit', (a) => a.getAttribute('href')), `${''}/index.html?card=1`);
    // a ref in the head opens the sheet in place
    await page.click('#thread-head .card-head-body a.cardref[data-shortid="2"]');
    await page.waitForSelector('#card-sheet[data-short-id="2"]', { timeout: 5000 });
    assert.match(page.url(), /commons\.html\?node=c1/, 'no navigation');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#card-sheet'), { timeout: 5000 });
    // the line above the box says what posting does, naming the PO from the board
    const note = await page.$eval('.cv-form .groom-note', (e) => e.textContent);
    assert.match(note, /adds to #1's thread/);
    assert.match(note, /wakes @pip/);
  }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } } });
});

test('#1391 served: no PO declared ⇒ the line says so; a non-card node thread has no head and no line', async () => {
  const rosterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'groom-head2-')), 'roster.json');
  fs.writeFileSync(rosterFile, JSON.stringify({ seats: SEATS }));
  const board = makeBoardFixture({ cards: [card(1, 'a card')], nextShortId: 2 });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html?node=c1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form .cv-input', { timeout: 5000 });
    assert.ok(await page.$('#thread-head.card-head'), 'the head shows without &groom=1 too — a card thread is a card thread');
    const note = await page.$eval('.cv-form .groom-note', (e) => e.textContent);
    assert.match(note, /no seat holds the PO role/);
    await page.goto(`${server.baseUrl}/commons.html?node=not-a-card`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form .cv-input', { timeout: 5000 });
    assert.equal(await page.$('#thread-head.card-head'), null, 'no head for a non-card node');
    assert.equal(await page.$('.cv-form .groom-note'), null, 'no line for a non-card node');
  }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } } });
});
