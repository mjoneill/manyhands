/**
 * #498 — a single click anywhere on a card must not change what OTHER cards
 * are visible. RED-first, non-author bar (Wren), from the card's
 * pre-registered acceptance, before the first build commit.
 *
 * The disease (Michael's live walkthrough + MiniMo's diagnosis): three on-card
 * chips — assignee, priority, label — are state-changing affordances disguised
 * as indicators. Aiming for "open this card" and catching a chip re-filters
 * the whole board: local gesture, global consequence, feedback only by
 * absence.
 *
 * DESIGN-AGNOSTIC ON PURPOSE. The card says the design is the builder's call
 * (filter bar, mode entry, inert labels — whatever wins). This suite asserts
 * ONLY the pre-registered invariant: after any single click on card A, the
 * set of OTHER visible cards is unchanged. It does not care whether the chips
 * became inert, moved to a filter bar, or grew a mode gate — it cares that
 * the cheapest accident on a card stopped having board-wide consequences.
 *
 * Two tiers:
 *   1. the three named chip types (the disease — these FAIL today)
 *   2. a sweep over every other [data-action] control on the card (edit,
 *      move, expand…) asserting the same invariant, with modal dismissal
 *      between clicks — so a future control that re-filters the board fails
 *      this suite by name instead of shipping as instance six.
 *
 * Both states per the sprint rule: a populated board, and a fresh clone whose
 * fixture CREATES its cards first (#499's lesson: an empty-state check that
 * finds nothing to click has verified nothing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';

function syntheticRosterFile() {
  const p = path.join(os.tmpdir(), `roster-498-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({
    seats: {
      zephyr: { name: 'Zephyr', glyph: '◇', color: '#7cc4a0' },
      quill: { name: 'Quill', glyph: '✒', color: '#c48ab0' },
    },
  }));
  return p;
}

function card(id, shortId, title, { assignees, labels, priority, column }) {
  return {
    id, shortId, title, description: `${title} body`, type: 'task',
    assignees, labels, for: '', priority, column, order: shortId,
    createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
  };
}

/** Four cards, two columns, distinct assignees/labels/priorities — so every
 * chip type exists and clicking one today filters at least two cards away. */
function populatedBoard() {
  return makeBoardFixture({
    cards: [
      card('c1', 1, 'Alpha', { assignees: ['zephyr'], labels: ['infra'], priority: 'p1', column: 'backlog' }),
      card('c2', 2, 'Beta', { assignees: ['quill'], labels: ['docs'], priority: 'p2', column: 'backlog' }),
      card('c3', 3, 'Gamma', { assignees: ['quill'], labels: ['infra'], priority: null, column: 'planned' }),
      card('c4', 4, 'Delta', { assignees: ['zephyr', 'quill'], labels: [], priority: 'p1', column: 'planned' }),
    ],
    nextShortId: 5,
  });
}

async function visibleCardIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.card')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.dataset.id)
      .sort());
}

/**
 * Click every matching control on the card with data-id=cardId, asserting the
 * OTHER-cards visibility invariant after each click. Returns offense strings.
 */
async function clickAndCheck(page, cardId, selectorWithinCard, offenses, tierName) {
  const count = await page.evaluate(({ cardId, sel }) => {
    const cardEl = document.querySelector(`.card[data-id="${cardId}"]`);
    return cardEl ? cardEl.querySelectorAll(sel).length : 0;
  }, { cardId, sel: selectorWithinCard });

  for (let i = 0; i < count; i++) {
    const before = await visibleCardIds(page);
    const clicked = await page.evaluate(({ cardId, sel, i }) => {
      const cardEl = document.querySelector(`.card[data-id="${cardId}"]`);
      const el = cardEl?.querySelectorAll(sel)[i];
      if (!el || el.disabled) return null;
      const desc = `${el.className} [${el.getAttribute('data-action') ?? 'no-action'}] "${(el.textContent || '').trim().slice(0, 30)}"`;
      el.click();
      return desc;
    }, { cardId, sel: selectorWithinCard, i });
    if (!clicked) continue;

    // Dismiss anything modal the click legitimately opened, then settle.
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 150));

    const after = await visibleCardIds(page);
    const others = (ids) => ids.filter((id) => id !== cardId);
    if (JSON.stringify(others(before)) !== JSON.stringify(others(after))) {
      offenses.push(
        `[${tierName}] clicking ${clicked} on card ${cardId} changed OTHER cards' visibility: ` +
        `${others(before).join(',')} → ${others(after).join(',')}`,
      );
      // Restore a clean slate for the next probe: reload the page.
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('.card', { timeout: 5000 });
    }
  }
}

const CHIP_SELECTOR = '.card-assignee, .card-priority, .label-tag';
const OTHER_CONTROLS = '[data-action]:not([data-action="toggle-assignee"]):not([data-action="toggle-priority"]):not([data-action="toggle-label"])';

async function runIsolationChecks(page, offenses) {
  const ids = await visibleCardIds(page);
  assert.ok(ids.length >= 2, `need at least 2 visible cards to test isolation, saw ${ids.length}`);
  for (const cardId of ids) {
    // Tier 1 — the named disease: chips.
    await clickAndCheck(page, cardId, CHIP_SELECTOR, offenses, 'chip');
    // Tier 2 — every other on-card control, same invariant.
    await clickAndCheck(page, cardId, OTHER_CONTROLS, offenses, 'control');
  }
}

test('#498 populated: no single click on any card changes which OTHER cards are visible', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({ board: populatedBoard(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });

    const offenses = [];
    await runIsolationChecks(page, offenses);
    assert.deepEqual(offenses, [],
      `misclick isolation offenses (${offenses.length}):\n${offenses.join('\n')}`);
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});

test('#498 fresh clone: cards created via the API obey the same isolation invariant', async () => {
  const rosterFile = syntheticRosterFile();
  const server = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    // #499's lesson: the empty-state fixture CREATES its content — an
    // empty-board pass with nothing to click verifies nothing.
    for (const [title, assignee, labels, priority] of [
      ['Fresh A', 'zephyr', ['infra'], 'p1'],
      ['Fresh B', 'quill', ['docs'], 'p2'],
    ]) {
      const r = await fetch(`${server.baseUrl}/api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, assignee, labels, priority, column: 'backlog', type: 'task' }),
      });
      assert.ok(r.ok, `fixture card create failed: ${r.status}`);
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });

    const offenses = [];
    await runIsolationChecks(page, offenses);
    assert.deepEqual(offenses, [],
      `fresh-clone misclick offenses (${offenses.length}):\n${offenses.join('\n')}`);
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(rosterFile, { force: true });
  }
});
