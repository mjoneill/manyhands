/**
 * #506 — a human edits the roster from the UI: add, rename, recolour,
 * remove — no agent, no filesystem. RED-first, non-author bar (Wren).
 *
 * Work items enumerated (checklist item 10) and where each lives:
 *   1. settings-page section editing roster.json at the DATA ROOT, four
 *      verbs → teeth 2-5, each verb asserted against the FILE (ground
 *      truth), through the UI only
 *   2. the one line of UI copy — changes apply on restart (the difficult
 *      issue at the heart of the card, decision recorded there) → tooth 1,
 *      and tooth 6 proves the copy tells the truth: the edit actually
 *      appears after a restart and NOT before
 *   3. OUT (not asserted, recorded): name-claim enforcement, history
 *      rewrite on rename, mid-session reload (next sprint's card)
 *   4. both states → populated instance with a roster file, AND the
 *      stranger's first edit on a fresh clone where roster.json DOES NOT
 *      EXIST YET — the editor must create it at the data root
 *
 * CONTRACT SELECTORS (the bar's interface; constants below if the build
 * ships different names):
 *   [data-roster-editor]              the settings section
 *   [data-roster-seat="<key>"]       one row per seat
 *   [data-roster-name] / [data-roster-color]   inputs inside a row
 *   [data-roster-add] / [data-roster-remove] / [data-roster-save]
 *      the verbs; save may be per-row or global — the suite clicks the
 *      nearest one inside the row, falling back to a global one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const EDITOR = '[data-roster-editor]';
const seatRow = (key) => `[data-roster-seat="${key}"]`;

function synthRoster(dir) {
  const p = path.join(dir, 'roster.json');
  fs.writeFileSync(p, JSON.stringify({
    seats: {
      zephyr: { name: 'Zephyrine', glyph: '◇', color: '#7cc4a0' },
      quill: { name: 'Quillemette', glyph: '✒', color: '#c48ab0' },
    },
  }, null, 2));
  return p;
}

async function saveIn(page, rowSel) {
  const done = await page.evaluate((rowSel) => {
    const row = rowSel ? document.querySelector(rowSel) : null;
    const btn = (row && row.querySelector('[data-roster-save]'))
      || document.querySelector('[data-roster-editor] [data-roster-save]');
    if (!btn) return false;
    btn.click();
    return true;
  }, rowSel);
  assert.ok(done, 'no [data-roster-save] control found');
  await new Promise((r) => setTimeout(r, 400));
}

test('#506 the editor exists, lists the real roster, and says plainly that changes apply on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-ed-'));
  const rosterFile = synthRoster(dir);
  const server = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/settings.html', { waitUntil: 'networkidle0' });

    const probe = await page.evaluate((EDITOR_SEL) => {
      const ed = document.querySelector(EDITOR_SEL);
      if (!ed || ed.offsetParent === null) return null;
      return { text: ed.textContent, rows: [...ed.querySelectorAll('[data-roster-seat]')].map((r) => r.getAttribute('data-roster-seat')) };
    }, EDITOR);
    assert.ok(probe, `no visible ${EDITOR} on the settings page — the roster is still agents-and-filesystem only`);
    assert.ok(probe.rows.includes('zephyr') && probe.rows.includes('quill'),
      `editor lists ${JSON.stringify(probe.rows)} — must show the seats from roster.json, not an example`);
    assert.match(probe.text, /restart|relaunch/i,
      'the one line of UI copy is missing — the restart delay must be documented behaviour, not a bug Michael reports later');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#506 rename + recolour through the UI persist to roster.json at the data root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-ed-'));
  const rosterFile = synthRoster(dir);
  const server = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(server.baseUrl + '/settings.html', { waitUntil: 'networkidle0' });

    const drove = await page.evaluate((rowSel) => {
      const row = document.querySelector(rowSel);
      if (!row) return false;
      const name = row.querySelector('[data-roster-name]');
      const color = row.querySelector('[data-roster-color]');
      if (!name || !color) return false;
      name.value = 'Zephyr Renamed';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      color.value = '#123456';
      color.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, seatRow('zephyr'));
    assert.ok(drove, 'zephyr row is missing [data-roster-name]/[data-roster-color] inputs');
    await saveIn(page, seatRow('zephyr'));

    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    assert.equal(onDisk.seats.zephyr?.name, 'Zephyr Renamed', 'rename did not reach roster.json');
    assert.equal(onDisk.seats.zephyr?.color?.toLowerCase(), '#123456', 'recolour did not reach roster.json');
    assert.equal(onDisk.seats.quill?.name, 'Quillemette', 'editing one seat must not disturb another');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#506 add + remove through the UI persist, and a restart makes the change live (the copy tells the truth)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-ed-'));
  const rosterFile = synthRoster(dir);
  const env = { SCRUM_ROSTER_FILE: rosterFile };
  let server = await startRestServer({ board: makeBoardFixture(), env });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(server.baseUrl + '/settings.html', { waitUntil: 'networkidle0' });

    // ADD a seat "koru".
    const added = await page.evaluate(() => {
      const add = document.querySelector('[data-roster-editor] [data-roster-add]');
      if (!add) return false;
      add.click();
      const rows = [...document.querySelectorAll('[data-roster-seat]')];
      const fresh = rows.find((r) => !['zephyr', 'quill'].includes(r.getAttribute('data-roster-seat'))) || rows.at(-1);
      const key = fresh.querySelector('[data-roster-key]');
      const name = fresh.querySelector('[data-roster-name]');
      if (name) { name.value = 'Koru'; name.dispatchEvent(new Event('input', { bubbles: true })); }
      if (key) { key.value = 'koru'; key.dispatchEvent(new Event('input', { bubbles: true })); }
      return !!name;
    });
    assert.ok(added, 'no [data-roster-add] flow reachable');
    await saveIn(page, null);
    let onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const addedKey = Object.keys(onDisk.seats).find((k) => !['zephyr', 'quill'].includes(k));
    assert.ok(addedKey, `add did not reach roster.json — seats are ${Object.keys(onDisk.seats).join(',')}`);

    // REMOVE quill.
    const removed = await page.evaluate((rowSel) => {
      const btn = document.querySelector(`${rowSel} [data-roster-remove]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, seatRow('quill'));
    assert.ok(removed, 'no [data-roster-remove] in the quill row');
    await saveIn(page, null);
    onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    assert.ok(!onDisk.seats.quill, 'remove did not reach roster.json');

    // The copy's claim, proven BOTH ways: not live before restart…
    const liveBefore = await page.evaluate(() => globalThis.__SCRUM_ROSTER__ || null);
    if (liveBefore) {
      assert.ok(!JSON.stringify(liveBefore).includes('Koru'),
        'the new seat is live WITHOUT a restart — then the UI copy is wrong and the mid-session-reload card just got built by accident');
    }
    // …and live after one.
    await server.stop();
    server = await startRestServer({ board: makeBoardFixture(), env });
    await page.goto(server.baseUrl + '/settings.html', { waitUntil: 'networkidle0' });
    const liveAfter = await page.evaluate(() => JSON.stringify(globalThis.__SCRUM_ROSTER__ || {}));
    assert.ok(liveAfter.includes('Koru'), 'after restart the added seat must be live');
    assert.ok(!liveAfter.includes('Quillemette'), 'after restart the removed seat must be gone');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#506 stranger's first edit: on a fresh clone with NO roster.json, the editor works and CREATES it at the data root", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-ed-fresh-'));
  const rosterFile = path.join(dir, 'roster.json'); // does not exist yet
  const server = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(server.baseUrl + '/settings.html', { waitUntil: 'networkidle0' });

    const editorThere = await page.evaluate((EDITOR_SEL) => {
      const ed = document.querySelector(EDITOR_SEL);
      return !!ed && ed.offsetParent !== null;
    }, EDITOR);
    assert.ok(editorThere, 'the editor must exist on a fresh clone — the stranger\'s first roster edit IS this flow');

    const droveAny = await page.evaluate(() => {
      const row = document.querySelector('[data-roster-seat]');
      const name = row?.querySelector('[data-roster-name]');
      if (!name) return false;
      name.value = 'First Edit';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    assert.ok(droveAny, 'no editable seat row on the fresh clone (the example roster should seed the editor)');
    await saveIn(page, null);

    assert.ok(fs.existsSync(rosterFile),
      'saving on a fresh clone must CREATE roster.json at the data root — a stranger has no agent to create it for them');
    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    assert.ok(JSON.stringify(onDisk).includes('First Edit'), 'the first edit must be in the created file');
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
