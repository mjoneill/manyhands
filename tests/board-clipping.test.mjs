/**
 * #499 — nothing on the board view silently truncates: the search affordance
 * documents its own syntax somewhere that survives typing, and assignee chips
 * never clip off their card. RED-first, non-author bar (the reviewing seat), from the
 * card's pre-registered acceptance (steward pass 2026-07-26) + the folded
 * #514 diagnosis (a fixed-width field inside a now-fluid page).
 *
 * Work items enumerated (checklist item 10):
 *   1. named viewport set 480/768/1024/1442, no truncated search string, no
 *      clipped chip at 1/2/3+ assignees → tests below, per viewport
 *   2. syntax help survives focus and is reachable WHILE COMPOSING → the
 *      composing tooth; the named cheat (builder's own): a SHORTENED
 *      placeholder passes "no truncation" while deleting the only syntax
 *      documentation that exists — so the operators must be findable in a
 *      visible element after typing begins, directly or behind ONE visible
 *      affordance inside the search control ([data-search-help] contract)
 *   3. both states; the empty-clone fixture CREATES its multi-assignee card
 *      (the board has none — build the artifact you then verify)
 *   4. beneficiary: the owner finds `type:` unaided — his tier, on the card
 *   5. path-walk screenshots — the reviewing seat's tier, at grade time
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const VIEWPORTS = [480, 768, 1024, 1442];
const OPERATORS = ['assignee:', 'label:', 'priority:', 'type:'];

function rosterFile() {
  const p = path.join(os.tmpdir(), `roster-499-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({
    seats: {
      zephyr: { name: 'Zephyrine', glyph: '◇', color: '#7cc4a0' },
      quill: { name: 'Quillemette', glyph: '✒', color: '#c48ab0' },
      ember: { name: 'Emberline', glyph: '✴', color: '#d4a24c' },
    },
  }));
  return p;
}

function card(id, shortId, title, assignees, column) {
  return {
    id, shortId, title, description: `${title} body`, type: 'task',
    assignees, labels: [], for: '', priority: null, column, order: shortId,
    createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
  };
}

function populatedBoard() {
  return makeBoardFixture({
    cards: [
      card('c1', 1, 'One assignee', ['zephyr'], 'backlog'),
      card('c2', 2, 'Two assignees', ['zephyr', 'quill'], 'backlog'),
      card('c3', 3, 'Three assignees', ['zephyr', 'quill', 'ember'], 'planned'),
    ],
    nextShortId: 4,
  });
}

/** Search tooth: placeholder untruncated, and the operator syntax reachable
 * while composing (after typing has begun, placeholder gone). */
async function checkSearch(page, vw, offenses) {
  const search = await page.evaluate(() => {
    const el = document.querySelector('#board-search-input, input[type="search"], .search input');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.textContent = el.placeholder || '';
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};`;
    document.body.appendChild(probe);
    const textW = probe.getBoundingClientRect().width;
    probe.remove();
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { placeholder: el.placeholder || '', textW, inner };
  });
  if (!search) { offenses.push(`@${vw}px: no search input found`); return; }
  if (search.textW > search.inner + 1) {
    offenses.push(`@${vw}px placeholder needs ${search.textW.toFixed(0)}px in ${search.inner.toFixed(0)}px — truncates mid-word`);
  }

  // Composing tooth: type, then the operators must be visible — directly, or
  // after clicking ONE visible [data-search-help] affordance in the control.
  await page.click('#board-search-input, input[type="search"], .search input');
  await page.keyboard.type('a');
  await new Promise((r) => setTimeout(r, 150));
  const visibleOps = () => page.evaluate((OPS) => {
    const vis = [...document.querySelectorAll('body *')].filter((el) => {
      if (el.closest('input, script, style')) return false;
      const r = el.getBoundingClientRect();
      return el.children.length === 0 && r.width > 0 && r.height > 0
        && r.bottom > 0 && r.top < window.innerHeight
        && getComputedStyle(el).visibility !== 'hidden';
    }).map((el) => el.textContent).join(' ');
    return OPS.filter((op) => vis.includes(op));
  }, OPERATORS);
  let ops = await visibleOps();
  if (ops.length < OPERATORS.length) {
    const clicked = await page.evaluate(() => {
      const help = document.querySelector('[data-search-help]');
      if (!help || help.offsetParent === null) return false;
      help.click();
      return true;
    });
    if (clicked) { await new Promise((r) => setTimeout(r, 150)); ops = await visibleOps(); }
  }
  if (ops.length < OPERATORS.length) {
    offenses.push(`@${vw}px while composing, operators missing from any visible element: ${OPERATORS.filter((o) => !ops.includes(o)).join(' ')} — syntax docs deleted or unreachable at the only moment they're needed`);
  }
  // Reset for the next viewport pass.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const el = document.querySelector('#board-search-input, input[type="search"], .search input');
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}

/** Chip tooth: every visible assignee chip fully inside its card; a 3+ card
 * either shows all chips or a +N affordance — silent loss fails. */
async function checkChips(page, vw, offenses) {
  const results = await page.evaluate(() => {
    return [...document.querySelectorAll('.card')].map((cardEl) => {
      const cr = cardEl.getBoundingClientRect();
      const chips = [...cardEl.querySelectorAll('.card-assignee')];
      const clipped = chips.filter((ch) => {
        const r = ch.getBoundingClientRect();
        return r.width > 0 && (r.right > cr.right + 2 || r.left < cr.left - 2);
      }).map((ch) => ch.textContent.trim());
      const plusN = !!cardEl.querySelector('[data-assignee-overflow], .assignee-more');
      const declared = (cardEl.textContent.match(/\+\d+/) || [null])[0];
      return {
        id: cardEl.dataset.id,
        visibleChips: chips.filter((ch) => ch.getBoundingClientRect().width > 0).length,
        clipped, plusN: plusN || !!declared,
      };
    });
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  for (const r of results) {
    for (const c of r.clipped) offenses.push(`@${vw}px card ${r.id}: chip "${c}" clips past the card edge`);
  }
  if (byId.c3 && byId.c3.visibleChips < 3 && !byId.c3.plusN) {
    offenses.push(`@${vw}px 3-assignee card shows ${byId.c3.visibleChips} chips and no +N — assignees silently lost`);
  }
}

test('#499 populated: no truncated search text, syntax reachable while composing, no clipped chips at any viewport', async () => {
  const rf = rosterFile();
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      const offenses = [];
      for (const vw of VIEWPORTS) {
        await page.setViewport({ width: vw, height: 900 });
        await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
        await page.waitForSelector('.card', { timeout: 5000 });
        await page.evaluate(() => Promise.race([
          Promise.allSettled(document.getAnimations().map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 1200)),
        ]));
        await checkSearch(page, vw, offenses);
        await checkChips(page, vw, offenses);
      }
      assert.deepEqual(offenses, [], `clipping offenses (${offenses.length}):\n${offenses.join('\n')}`);
    }, { server: { board: populatedBoard(), env: { SCRUM_ROSTER_FILE: rf } }, launch: { headless: 'new' } });
  } finally {
    fs.rmSync(rf, { force: true });
  }
});

test('#499 fresh clone: the fixture CREATES a 3-assignee card, then the same bars hold', async () => {
  const rf = rosterFile();
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const r = await fetch(`${server.baseUrl}/api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Fresh multi', assignees: ['zephyr', 'quill', 'ember'], column: 'backlog', type: 'task', description: 'created by the fixture' }),
      });
      assert.ok(r.ok, `fixture create failed: ${r.status}`);
      const created = await r.json();
      const cardId = created.id ?? created.card?.id;

      const page = await browser.newPage();
      const offenses = [];
      for (const vw of VIEWPORTS) {
        await page.setViewport({ width: vw, height: 900 });
        await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
        await page.waitForSelector('.card', { timeout: 5000 });
        await page.evaluate(() => Promise.race([
          Promise.allSettled(document.getAnimations().map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 1200)),
        ]));
        await checkSearch(page, vw, offenses);
        // The created card is the c3-equivalent here.
        const probe = await page.evaluate((cid) => {
          const cardEl = document.querySelector(`.card[data-id="${cid}"]`) || document.querySelector('.card');
          const cr = cardEl.getBoundingClientRect();
          const chips = [...cardEl.querySelectorAll('.card-assignee')];
          return {
            visible: chips.filter((ch) => ch.getBoundingClientRect().width > 0).length,
            clipped: chips.filter((ch) => { const r2 = ch.getBoundingClientRect(); return r2.width > 0 && r2.right > cr.right + 2; }).length,
            plusN: !!cardEl.querySelector('[data-assignee-overflow], .assignee-more') || /\+\d+/.test(cardEl.textContent),
          };
        }, cardId);
        if (probe.clipped > 0) offenses.push(`@${vw}px fresh-clone card clips ${probe.clipped} chip(s)`);
        if (probe.visible < 3 && !probe.plusN) offenses.push(`@${vw}px fresh-clone 3-assignee card shows ${probe.visible} chips, no +N`);
      }
      assert.deepEqual(offenses, [], `fresh-clone clipping offenses (${offenses.length}):\n${offenses.join('\n')}`);
    }, { server: { board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rf } }, launch: { headless: 'new' } });
  } finally {
    fs.rmSync(rf, { force: true });
  }
});
